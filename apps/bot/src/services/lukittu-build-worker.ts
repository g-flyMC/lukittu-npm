import { logger, prisma } from '@lukittu/shared';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createHmac } from 'crypto';
import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

/**
 * Surveille ReleaseFileObfuscation (status PENDING) et, pour chaque entree,
 * lance la chaine complete : telechargement du jar brut -> outil de build
 * Phase D (renomme + wrapper + config auto-remplie) -> ZKM (si configure) ->
 * reupload du resultat a la meme cle S3 -> status SUCCESS/FAILED.
 *
 * Variables d'environnement necessaires (en plus de celles deja requises
 * par le bot) :
 *   LUKITTU_BUILD_TOOL_JAR   chemin vers lukittu-loader-build-tool.jar
 *   LUKITTU_ZKM_JAR          chemin vers TON ZKM.jar (optionnel -- si absent,
 *                            l'etape ZKM est sautee, seule la Phase D tourne)
 *   LUKITTU_ZKM_SCRIPT_TEMPLATE  chemin vers un script .zkm avec les
 *                            placeholders @IN@/@OUT@/@MAIN_CLASS@ (optionnel)
 *
 * NON TESTE contre une vraie instance Lukittu (pas de DB/S3 reels en
 * sandbox) -- la logique Prisma/S3 est relue a la main contre le vrai
 * schema et le vrai client S3 de apps/web, mais ce fichier n'a pas tourne
 * en conditions reelles. A valider chez toi, les logs (logger.error) te
 * diront precisement ce qui coince le cas echeant.
 */

const POLL_INTERVAL_MS = 15_000;

let s3Client: S3Client | null = null;
function getS3Client() {
  if (!s3Client) {
    s3Client = new S3Client({
      endpoint: process.env.PRIVATE_OBJECT_STORAGE_ENDPOINT,
      region: process.env.PRIVATE_OBJECT_STORAGE_REGION || 'auto',
      credentials: {
        accessKeyId: process.env.PRIVATE_OBJECT_STORAGE_ACCESS_KEY!,
        secretAccessKey: process.env.PRIVATE_OBJECT_STORAGE_SECRET_KEY!,
      },
      forcePathStyle: true,
    });
  }
  return s3Client;
}

const BUCKET = process.env.PRIVATE_OBJECT_STORAGE_BUCKET_NAME!;

async function downloadFromS3(key: string): Promise<Buffer> {
  const res = await getS3Client().send(
    new GetObjectCommand({ Bucket: BUCKET, Key: key }),
  );
  const chunks: Buffer[] = [];
  for await (const chunk of res.Body as AsyncIterable<Buffer>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function uploadToS3(key: string, data: Buffer) {
  await getS3Client().send(
    new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: data }),
  );
}

/** Secret stable par produit, derive de ENCRYPTION_KEY -- pas de nouvelle colonne DB. */
function deriveProductSecret(productId: string): string {
  return createHmac('sha256', process.env.ENCRYPTION_KEY!)
    .update(productId)
    .digest('hex');
}

// Le container du bot (image Node) n'a pas de JRE par defaut -- voir
// install.sh, qui telecharge un JRE portable dans /home/container/jre.
// Surchargeable si tu as deja un `java` sur le PATH autrement.
const JAVA_BIN = process.env.LUKITTU_JAVA_BIN || 'java';

function runProcess(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'pipe' });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} a quitte avec le code ${code}: ${stderr}`));
    });
  });
}

async function processOne(obfuscationId: string) {
  const entry = await prisma.releaseFileObfuscation.findUnique({
    where: { id: obfuscationId },
    include: {
      releaseFile: {
        include: {
          release: { include: { product: true } },
        },
      },
    },
  });
  if (!entry) return;

  const { releaseFile } = entry;
  const { release } = releaseFile;
  const { product } = release;

  await prisma.releaseFileObfuscation.update({
    where: { id: entry.id },
    data: { buildStartedAt: new Date(), errorMessage: null },
  });

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lukittu-build-'));
  try {
    if (!releaseFile.mainClassName) {
      throw new Error(
        'mainClassName manquant sur ce ReleaseFile -- requis en mode INTEGRE pour savoir quelle classe renommer.',
      );
    }

    const rawJarPath = path.join(tmpDir, 'input.jar');
    const configPath = path.join(tmpDir, 'config.properties');
    const integratedJarPath = path.join(tmpDir, 'integrated.jar');
    const finalJarPath = path.join(tmpDir, 'final.jar');

    const rawBytes = await downloadFromS3(releaseFile.key);
    await fs.writeFile(rawJarPath, rawBytes);

    const keyPair = await prisma.keyPair.findUnique({
      where: { teamId: release.teamId },
    });
    if (!keyPair) throw new Error('Aucune KeyPair pour cette team.');

    const targetTypeStr =
      product.targetType === 'SERVER_CORE' ? 'SERVER_CORE' : 'PLUGIN';
    const configLines = [
      `base-url=${process.env.NEXT_PUBLIC_BASE_URL}`,
      `team-id=${release.teamId}`,
      `product-id=${product.id}`,
      `team-public-key=${keyPair.publicKey.replace(/\n/g, '\\n')}`,
      `product-secret=${deriveProductSecret(product.id)}`,
      `channel=all`,
    ];
    await fs.writeFile(configPath, configLines.join('\n'));

    const buildToolJar = process.env.LUKITTU_BUILD_TOOL_JAR;
    if (!buildToolJar) {
      throw new Error('LUKITTU_BUILD_TOOL_JAR non configure.');
    }

    logger.info('Lukittu build worker: lancement Phase D', {
      productId: product.id,
      releaseFileId: releaseFile.id,
    });

    await runProcess(JAVA_BIN, [
      '-cp',
      buildToolJar,
      'fr.sodacraft.lukittuloader.build.Main',
      rawJarPath,
      integratedJarPath,
      releaseFile.mainClassName,
      targetTypeStr,
      configPath,
    ]);

    let resultJarPath = integratedJarPath;

    const zkmJar = process.env.LUKITTU_ZKM_JAR;
    const zkmScriptTemplate = process.env.LUKITTU_ZKM_SCRIPT_TEMPLATE;
    if (zkmJar && zkmScriptTemplate) {
      logger.info('Lukittu build worker: lancement ZKM', {
        productId: product.id,
      });
      const scriptContent = (await fs.readFile(zkmScriptTemplate, 'utf8'))
        .split('@IN@')
        .join(integratedJarPath)
        .split('@OUT@')
        .join(finalJarPath)
        .split('@MAIN_CLASS@')
        .join(releaseFile.mainClassName);
      const scriptPath = path.join(tmpDir, 'script.zkm');
      await fs.writeFile(scriptPath, scriptContent);

      await runProcess(JAVA_BIN, ['-jar', zkmJar, scriptPath]);
      resultJarPath = finalJarPath;
    } else {
      logger.warn(
        'Lukittu build worker: LUKITTU_ZKM_JAR non configure, obfuscation ZKM SAUTEE (jar Phase D seul, non obfusque).',
      );
    }

    const finalBytes = await fs.readFile(resultJarPath);
    await uploadToS3(releaseFile.key, finalBytes); // remplace le jar brut par le jar protege, meme cle S3

    await prisma.releaseFileObfuscation.update({
      where: { id: entry.id },
      data: {
        status: 'SUCCESS',
        buildFinishedAt: new Date(),
        zkmVersion: zkmJar ? 'configure (voir LUKITTU_ZKM_JAR)' : 'non-applique',
      },
    });

    logger.info('Lukittu build worker: succes', {
      productId: product.id,
      releaseFileId: releaseFile.id,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Lukittu build worker: echec', {
      obfuscationId: entry.id,
      error: message,
    });
    await prisma.releaseFileObfuscation.update({
      where: { id: entry.id },
      data: { status: 'FAILED', buildFinishedAt: new Date(), errorMessage: message },
    });
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

export function startLukittuBuildWorker() {
  setInterval(async () => {
    try {
      const pending = await prisma.releaseFileObfuscation.findFirst({
        where: { status: 'PENDING' },
        orderBy: { createdAt: 'asc' },
      });
      if (pending) await processOne(pending.id);
    } catch (error) {
      logger.error('Lukittu build worker: erreur de polling', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, POLL_INTERVAL_MS);

  logger.info('Lukittu build worker demarre (polling toutes les 15s)');
}
