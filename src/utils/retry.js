import { sleep, log } from "./helpers.js";
import config from "../config/env.js";

/**
 * 429 에러 전용 대기 시간
 */
const RATE_LIMIT_DELAY = 5000; // 5초

/**
 * 429 에러 감지
 */
function isRateLimitError(error) {
  if (!error) return false;

  const message = error.message || "";
  const status = error.response?.status;

  // 429 상태 코드
  if (status === 429) return true;

  // 에러 메시지에 429 포함
  if (message.includes("429")) return true;
  if (message.includes("Too Many Requests")) return true;
  if (message.includes("rate limit")) return true;

  return false;
}

/**
 * 재시도 with 429 대응
 */
export async function retryWithBackoff(fn, context = "Operation") {
  let attempt = 0;
  let rateLimitCount = 0;

  while (true) {
    try {
      attempt++;
      if (attempt > 1) {
        log("info", `${context} 재시도 ${attempt}회...`);
      }

      const result = await fn();

      if (attempt > 1) {
        log("info", `${context} 성공!`);
      }

      return result;
    } catch (error) {
      // ⚡ 429 에러 특별 처리
      if (isRateLimitError(error)) {
        rateLimitCount++;
        log("warn", `⚠️  API 호출 제한 (429) - ${rateLimitCount}회 발생`);
        log("warn", `${RATE_LIMIT_DELAY}ms 대기 후 재시도...`);

        // 5초 대기
        await sleep(RATE_LIMIT_DELAY);

        // 3회 이상 연속 429 에러면 더 오래 대기
        if (rateLimitCount >= 3) {
          const extraDelay = 10000; // 10초 추가
          log(
            "warn",
            `연속 429 에러 ${rateLimitCount}회, ${extraDelay}ms 추가 대기...`
          );
          await sleep(extraDelay);
        }

        continue;
      }

      // 성공했으면 429 카운터 리셋
      rateLimitCount = 0;

      log("error", `${context} 실패 (${attempt}회): ${error.message}`);

      // 치명적 에러는 즉시 throw
      if (
        error.message.includes("insufficient") ||
        error.message.includes("invalid") ||
        error.message.includes("forbidden")
      ) {
        throw error;
      }

      // 일반 에러는 지수 백오프
      const delay = Math.min(
        config.API_RETRY_DELAY *
          Math.pow(config.API_RETRY_BACKOFF, attempt - 1),
        60000 // 최대 1분
      );

      log("info", `${delay}ms 후 재시도...`);
      await sleep(delay);
    }
  }
}

/**
 * 편의 함수
 */
export async function executeWithRetry(fn, context = "API Call") {
  return retryWithBackoff(fn, context);
}
