export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 안전한 숫자 변환
 */
export function toNumber(value, defaultValue = 0) {
  if (value === null || value === undefined) {
    return defaultValue;
  }

  const num = Number(value);

  if (isNaN(num) || !isFinite(num)) {
    return defaultValue;
  }

  return num;
}

/**
 * 안전한 toFixed (숫자가 아니면 기본값 반환)
 */
export function safeToFixed(value, decimals = 2, defaultValue = 0) {
  const num = toNumber(value, defaultValue);
  return num.toFixed(decimals);
}

export function formatNumber(num, decimals = 2) {
  const number = toNumber(num, 0);
  return Number(number.toFixed(decimals));
}

export function formatKRW(amount) {
  const number = toNumber(amount, 0);
  return new Intl.NumberFormat("ko-KR", {
    style: "currency",
    currency: "KRW",
  }).format(number);
}

export function formatPercent(value, decimals = 2) {
  const number = toNumber(value, 0);
  return `${formatNumber(number, decimals)}%`;
}

export function getCurrentTime() {
  return new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
}

export function log(level, message, data = null) {
  const timestamp = new Date().toLocaleTimeString("ko-KR");

  const icons = {
    info: "💬",
    warn: "⚠️",
    error: "❌",
    debug: "🔍",
    success: "✅",
    trade: "💰",
  };

  const icon = icons[level] || "📝";
  const color =
    {
      info: "\x1b[36m", // cyan
      warn: "\x1b[33m", // yellow
      error: "\x1b[31m", // red
      debug: "\x1b[90m", // gray
      success: "\x1b[32m", // green
      trade: "\x1b[35m", // magenta
    }[level] || "\x1b[0m";

  const reset = "\x1b[0m";

  console.log(`${color}${icon} [${timestamp}] ${message}${reset}`);

  if (data) {
    console.log(
      color +
        "   " +
        JSON.stringify(data, null, 2).split("\n").join("\n   ") +
        reset
    );
  }
}

export function calculateAverage(arr) {
  if (!arr || arr.length === 0) return 0;

  // 배열의 모든 값을 안전하게 숫자로 변환
  const numbers = arr.map((val) => toNumber(val, 0));

  const sum = numbers.reduce((sum, val) => sum + val, 0);
  return sum / numbers.length;
}

export function calculateStdDev(arr, mean = null) {
  if (!arr || arr.length === 0) return 0;

  const numbers = arr.map((val) => toNumber(val, 0));
  const avg = mean !== null ? toNumber(mean, 0) : calculateAverage(numbers);

  const squareDiffs = numbers.map((value) => Math.pow(value - avg, 2));
  const avgSquareDiff = calculateAverage(squareDiffs);

  return Math.sqrt(avgSquareDiff);
}

export function roundToTickSize(price, tickSize = 1) {
  const number = toNumber(price, 0);
  const tick = toNumber(tickSize, 1);
  return Math.round(number / tick) * tick;
}
