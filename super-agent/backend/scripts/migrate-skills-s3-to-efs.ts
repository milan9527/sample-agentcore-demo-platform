/**
 * One-time migration: copy skill files from the S3 SKILLS bucket to the EFS
 * shared skill dirs, and repoint each skills row's metadata.localPath.
 *
 * Idempotent: skips rows whose files already exist on EFS.
 *
 * Prereqs:
 *   - EFS mounted on this host at AGENT_WORKSPACE_BASE_DIR (/mnt/efs)
 *   - AGENTCORE_STORAGE=efs (so getSharedSkillDir resolves to the EFS path)
 *   - AWS creds able to read the SKILLS bucket
 *
 * Run:  npx tsx scripts/migrate-skills-s3-to-efs.ts [--dry-run]
 */

import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { mkdir, writeFile, access, readdir } from 'fs/promises';
import { join, dirname } from 'path';
import { execSync } from 'child_process';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { createWriteStream } from 'fs';
import { config } from '../src/config/index.js';
import { prisma } from '../src/config/database.js';
import { getSharedSkillDir } from '../src/services/skill.service.js';

const DRY_RUN = process.argv.includes('--dry-run');
const s3 = new S3Client({ region: config.aws.region });

async function dirHasFiles(dir: string): Promise<boolean> {
  try {
    await access(dir);
    const entries = await readdir(dir);
    return entries.length > 0;
  } catch {
    return false;
  }
}

async function migrateOne(orgId: string, hashId: string, bucket: string, prefix: string): Promise<number> {
  const destDir = getSharedSkillDir(orgId, hashId);
  if (await dirHasFiles(destDir)) {
    console.log(`  [skip] ${destDir} already populated`);
    return 0;
  }
  await mkdir(destDir, { recursive: true });

  // List everything under the S3 prefix.
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const res = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    for (const o of res.Contents ?? []) if (o.Key) keys.push(o.Key);
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);

  if (keys.length === 0) {
    console.log(`  [warn] no S3 objects under s3://${bucket}/${prefix}`);
    return 0;
  }

  let copied = 0;
  for (const key of keys) {
    const rel = key.slice(prefix.length);
    if (!rel) continue;
    const dest = join(destDir, rel);
    if (DRY_RUN) { console.log(`  would copy ${key} → ${dest}`); copied++; continue; }
    await mkdir(dirname(dest), { recursive: true });
    const resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!resp.Body) continue;
    await pipeline(resp.Body as Readable, createWriteStream(dest));
    copied++;
  }

  // If the only artifact was skill.zip, unzip it in place.
  const zipPath = join(destDir, 'skill.zip');
  if (!DRY_RUN && (await dirHasFiles(destDir))) {
    try {
      await access(zipPath);
      execSync(`unzip -o "${zipPath}" -d "${destDir}"`, { stdio: 'ignore' });
      execSync(`rm -f "${zipPath}"`, { stdio: 'ignore' });
      console.log(`  unzipped skill.zip`);
    } catch { /* no zip — individual files already copied */ }
  }
  return copied;
}

async function main() {
  if (config.agentcore.storage !== 'efs') {
    console.error('AGENTCORE_STORAGE is not "efs" — set it (and mount EFS) before migrating.');
    process.exit(1);
  }
  console.log(`Migrating skills S3 → EFS (base=${config.claude.workspaceBaseDir})${DRY_RUN ? ' [DRY RUN]' : ''}`);

  const skills = await prisma.skills.findMany({
    select: { id: true, organization_id: true, hash_id: true, name: true, s3_bucket: true, s3_prefix: true, metadata: true },
  });
  console.log(`Found ${skills.length} skills`);

  let migrated = 0, skipped = 0, failed = 0;
  for (const s of skills) {
    const meta = (s.metadata as Record<string, unknown> | null) ?? {};
    const localPath = meta.localPath as string | undefined;
    const destDir = getSharedSkillDir(s.organization_id, s.hash_id);

    // Already on EFS?
    if (localPath === destDir && (await dirHasFiles(destDir))) { skipped++; continue; }
    if (!s.s3_bucket || !s.s3_prefix) { console.log(`[${s.name}] no S3 source — skip`); skipped++; continue; }

    try {
      console.log(`[${s.name}] ${s.organization_id}/${s.hash_id}`);
      const n = await migrateOne(s.organization_id, s.hash_id, s.s3_bucket, s.s3_prefix);
      if (!DRY_RUN) {
        await prisma.skills.update({
          where: { id: s.id },
          data: { metadata: { ...meta, localPath: destDir } as object },
        });
      }
      console.log(`  → ${n} files, metadata.localPath = ${destDir}`);
      migrated++;
    } catch (err) {
      console.error(`  [FAIL] ${s.name}:`, err instanceof Error ? err.message : err);
      failed++;
    }
  }

  console.log(`\nDone. migrated=${migrated} skipped=${skipped} failed=${failed}`);
  await prisma.$disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
