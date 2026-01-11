#!/usr/bin/env node

/**
 * 거래 로그 초기화 스크립트
 * 사용: npm run clean-logs
 */

import fs from "fs";
import path from "path";
import readline from "readline";

const LOGS_DIR = "./logs";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function question(query) {
  return new Promise((resolve) => rl.question(query, resolve));
}

async function main() {
  console.log("\n" + "═".repeat(70));
  console.log("🗑️  거래 로그 초기화");
  console.log("═".repeat(70));

  if (!fs.existsSync(LOGS_DIR)) {
    console.log("\n✅ 로그 디렉토리가 없습니다. 초기화 불필요.");
    rl.close();
    return;
  }

  const files = fs.readdirSync(LOGS_DIR);
  if (!files.length) {
    console.log("\n✅ 로그 파일이 없습니다. 초기화 불필요.");
    rl.close();
    return;
  }

  console.log("\n📁 발견된 로그 파일:");
  for (const file of files) {
    const stat = fs.statSync(path.join(LOGS_DIR, file));
    console.log(`   - ${file} (${(stat.size / 1024).toFixed(1)} KB)`);
  }

  const answer = await question(
    "\n⚠️  모든 로그를 삭제하시겠습니까? (yes/no): "
  );

  if (answer.toLowerCase() !== "yes") {
    console.log("\n❌ 취소되었습니다.");
    rl.close();
    return;
  }

  // 백업 생성
  const backupDir = path.join(LOGS_DIR, `backup_${Date.now()}`);
  fs.mkdirSync(backupDir, { recursive: true });

  console.log(`\n📦 백업 생성 중: ${backupDir}`);
  for (const file of files) {
    const src = path.join(LOGS_DIR, file);
    const dest = path.join(backupDir, file);
    if (fs.statSync(src).isFile()) {
      fs.copyFileSync(src, dest);
      console.log(`   ✓ ${file} 백업 완료`);
    }
  }

  // 로그 파일 삭제
  console.log("\n🗑️  로그 파일 삭제 중...");
  for (const file of files) {
    const filePath = path.join(LOGS_DIR, file);
    if (fs.statSync(filePath).isFile()) {
      fs.unlinkSync(filePath);
      console.log(`   ✓ ${file} 삭제 완료`);
    }
  }

  console.log("\n✅ 초기화 완료!");
  console.log(`   백업 위치: ${backupDir}`);
  console.log("═".repeat(70) + "\n");

  rl.close();
}

main().catch((err) => {
  console.error("❌ 오류:", err.message);
  rl.close();
  process.exit(1);
});
