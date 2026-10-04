-- CreateEnum
CREATE TYPE "ProtectionMode" AS ENUM ('NONE', 'LOADER', 'INTEGRATED');

-- CreateEnum
CREATE TYPE "ProductTargetType" AS ENUM ('PLUGIN', 'SERVER_CORE');

-- CreateEnum
CREATE TYPE "UpdatePolicyMode" AS ENUM ('AUTO', 'MANUAL');

-- CreateEnum
CREATE TYPE "ReleaseChannelPolicy" AS ENUM ('STABLE_ONLY', 'ALL_CHANNELS');

-- CreateEnum
CREATE TYPE "ObfuscationStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED');

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "protectionMode" "ProtectionMode" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "targetType" "ProductTargetType" NOT NULL DEFAULT 'PLUGIN',
ADD COLUMN     "updatePolicyMode" "UpdatePolicyMode" NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "releaseChannelPolicy" "ReleaseChannelPolicy" NOT NULL DEFAULT 'ALL_CHANNELS';

-- CreateTable
CREATE TABLE "ReleaseFileObfuscation" (
    "id" TEXT NOT NULL,
    "releaseFileId" TEXT NOT NULL,
    "zkmVersion" TEXT NOT NULL,
    "status" "ObfuscationStatus" NOT NULL DEFAULT 'PENDING',
    "buildStartedAt" TIMESTAMP(3),
    "buildFinishedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReleaseFileObfuscation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReleaseFileObfuscation_releaseFileId_key" ON "ReleaseFileObfuscation"("releaseFileId");

-- AddForeignKey
ALTER TABLE "ReleaseFileObfuscation" ADD CONSTRAINT "ReleaseFileObfuscation_releaseFileId_fkey" FOREIGN KEY ("releaseFileId") REFERENCES "ReleaseFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
