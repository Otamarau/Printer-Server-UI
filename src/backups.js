const fs = require("node:fs/promises");
const path = require("node:path");

const { BACKUP_DIR, BACKUP_RETENTION_COUNT, DATA_DIR } = require("./config");
function backupTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function listDataJsonFiles() {
  await fs.mkdir(DATA_DIR, { recursive: true });

  const entries = await fs.readdir(DATA_DIR, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
}

async function pruneOldBackups() {
  if (BACKUP_RETENTION_COUNT < 1) {
    return;
  }

  const entries = await fs.readdir(BACKUP_DIR, { withFileTypes: true });
  const backupDirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();

  const oldBackupDirs = backupDirs.slice(BACKUP_RETENTION_COUNT);

  await Promise.all(
    oldBackupDirs.map((backupDir) => (
      fs.rm(path.join(BACKUP_DIR, backupDir), { recursive: true, force: true })
    )),
  );
}

async function backupDatabase() {
  const files = await listDataJsonFiles();

  if (!files.length) {
    return null;
  }

  const backupPath = path.join(BACKUP_DIR, backupTimestamp());
  await fs.mkdir(backupPath, { recursive: true });

  await Promise.all(
    files.map((file) => (
      fs.copyFile(path.join(DATA_DIR, file), path.join(backupPath, file))
    )),
  );

  await pruneOldBackups();

  return {
    backupPath,
    fileCount: files.length,
  };
}

async function runScheduledBackup() {
  try {
    const result = await backupDatabase();

    if (result) {
      console.log(`Backed up ${result.fileCount} data file(s) to ${result.backupPath}`);
    }
  } catch (error) {
    console.error("Database backup failed:", error);
  }
}
module.exports = {
  backupDatabase,
  runScheduledBackup,
};
