import fs from "fs";
import path from "path";
import { log } from "../utils/helpers.js";

const STATE_FILE = "logs/state.json";

class StateManager {
  constructor() {
    this.ensureLogDirectory();
  }

  ensureLogDirectory() {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  saveState(state) {
    try {
      const data = {
        ...state,
        lastUpdate: new Date().toISOString(),
      };

      // 임시 파일에 먼저 쓰기 (원자적 쓰기)
      const tempFile = STATE_FILE + ".tmp";
      fs.writeFileSync(tempFile, JSON.stringify(data, null, 2));

      // 성공하면 원본 파일로 이동
      fs.renameSync(tempFile, STATE_FILE);

      log("debug", "💾 상태 저장 완료");
    } catch (error) {
      log("error", "상태 저장 실패", error.message);
    }
  }

  loadState() {
    try {
      if (!fs.existsSync(STATE_FILE)) {
        log("info", "📂 저장된 상태 없음 - 새로 시작");
        return null;
      }

      // 파일 읽기
      const fileContent = fs.readFileSync(STATE_FILE, "utf8");

      // 빈 파일 체크
      if (!fileContent || fileContent.trim().length === 0) {
        log("warn", "⚠️ 상태 파일이 비어있음 - 삭제 후 새로 시작");
        fs.unlinkSync(STATE_FILE);
        return null;
      }

      // JSON 파싱
      const state = JSON.parse(fileContent);

      // 유효성 검증
      if (!state || typeof state !== "object") {
        log("warn", "⚠️ 상태 데이터가 유효하지 않음 - 새로 시작");
        fs.unlinkSync(STATE_FILE);
        return null;
      }

      log("info", `📂 이전 상태 복구: ${state.lastUpdate || "알 수 없음"}`);
      return state;
    } catch (error) {
      // JSON 파싱 에러 또는 파일 읽기 에러
      if (error instanceof SyntaxError) {
        log("warn", `⚠️ 상태 파일 손상됨 (JSON 에러) - 삭제 후 새로 시작`);
      } else {
        log("error", "상태 복구 실패", error.message);
      }

      // 손상된 파일 삭제
      try {
        if (fs.existsSync(STATE_FILE)) {
          fs.unlinkSync(STATE_FILE);
          log("info", "🗑️ 손상된 상태 파일 삭제 완료");
        }
      } catch (deleteError) {
        log("error", "상태 파일 삭제 실패", deleteError.message);
      }

      return null;
    }
  }

  clearState() {
    try {
      if (fs.existsSync(STATE_FILE)) {
        fs.unlinkSync(STATE_FILE);
        log("info", "🗑️ 상태 파일 삭제");
      }
    } catch (error) {
      log("error", "상태 삭제 실패", error.message);
    }
  }

  /**
   * 상태 파일이 존재하고 유효한지 체크
   */
  isStateValid() {
    try {
      if (!fs.existsSync(STATE_FILE)) {
        return false;
      }

      const fileContent = fs.readFileSync(STATE_FILE, "utf8");

      if (!fileContent || fileContent.trim().length === 0) {
        return false;
      }

      const state = JSON.parse(fileContent);
      return state && typeof state === "object";
    } catch (error) {
      return false;
    }
  }

  /**
   * 상태 파일 복구 (백업에서)
   */
  recoverFromBackup() {
    try {
      const backupFile = STATE_FILE + ".backup";

      if (fs.existsSync(backupFile)) {
        fs.copyFileSync(backupFile, STATE_FILE);
        log("success", "✅ 백업에서 상태 복구 완료");
        return true;
      }

      return false;
    } catch (error) {
      log("error", "백업 복구 실패", error.message);
      return false;
    }
  }

  /**
   * 백업 생성
   */
  createBackup() {
    try {
      if (fs.existsSync(STATE_FILE) && this.isStateValid()) {
        const backupFile = STATE_FILE + ".backup";
        fs.copyFileSync(STATE_FILE, backupFile);
        log("debug", "💾 상태 백업 생성");
      }
    } catch (error) {
      log("error", "백업 생성 실패", error.message);
    }
  }
}

export default new StateManager();
