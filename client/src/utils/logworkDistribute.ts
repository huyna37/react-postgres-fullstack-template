export type LogworkDistributeInput = {
  key: string;
  /** Estimate gốc (giờ) */
  estimateHours: number;
  /** Giờ còn log được = max(0, est − đã log tổng trên ticket) */
  remainingHours: number;
};

export type LogworkDistributeRow = LogworkDistributeInput & {
  hours: number;
  seconds: number;
  timeSpent: string;
};

/** Jira chỉ nhận `2h`, `45m`, `1h 30m` — không nhận `1.75h`. */
export function formatSecondsToJiraTime(seconds: number): string {
  const n = Math.max(0, Math.round(seconds));
  if (n <= 0) return '0m';
  let hours = Math.floor(n / 3600);
  let minutes = Math.round((n % 3600) / 60);
  if (minutes === 60) {
    hours += 1;
    minutes = 0;
  }
  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h`;
  return minutes > 0 ? `${minutes}m` : '1m';
}

function getCapacityHours(it: LogworkDistributeInput): number {
  if (it.remainingHours > 0) return it.remainingHours;
  if (it.estimateHours > 0) return it.estimateHours;
  return Infinity;
}

function getWeightHours(it: LogworkDistributeInput): number {
  if (it.remainingHours > 0) return it.remainingHours;
  if (it.estimateHours > 0) return it.estimateHours;
  return 1;
}

function roundSecondsToMinutes(totalSeconds: number, rawSeconds: number[]): number[] {
  const floored = rawSeconds.map(s => Math.floor(s / 60) * 60);
  let remainder = totalSeconds - floored.reduce((a, b) => a + b, 0);
  const order = rawSeconds
    .map((s, i) => ({ i, frac: s - floored[i] }))
    .sort((a, b) => b.frac - a.frac);
  const seconds = [...floored];
  for (const { i } of order) {
    if (remainder < 60) break;
    seconds[i] += 60;
    remainder -= 60;
  }
  if (remainder > 0 && seconds.length > 0) {
    seconds[seconds.length - 1] += remainder;
  }
  return seconds;
}

/**
 * Chia giờ log theo tỉ lệ phần còn lại của estimate; không vượt trần est − đã log.
 * Ticket không est: chia đều, không giới hạn trần.
 */
export function distributeLogworkHours(
  items: LogworkDistributeInput[],
  targetHours: number
): LogworkDistributeRow[] {
  if (!items.length || !Number.isFinite(targetHours) || targetHours <= 0) return [];

  const eligible = items
    .map(it => ({
      ...it,
      capacity: getCapacityHours(it),
      weight: getWeightHours(it),
    }))
    .filter(it => it.capacity === Infinity || it.capacity > 0);

  if (!eligible.length) return [];

  const hasUnlimited = eligible.some(it => it.capacity === Infinity);
  const finiteCapSum = eligible
    .filter(it => it.capacity !== Infinity)
    .reduce((s, it) => s + it.capacity, 0);

  const budgetHours = hasUnlimited ? targetHours : Math.min(targetHours, finiteCapSum);
  if (budgetHours <= 0) return [];

  const weightSum = eligible.reduce((s, it) => s + it.weight, 0) || eligible.length;
  const rawHours = eligible.map(it => (it.weight / weightSum) * budgetHours);
  const allocHours = rawHours.map((h, i) => {
    const cap = eligible[i].capacity;
    return cap === Infinity ? h : Math.min(h, cap);
  });

  let slack = budgetHours - allocHours.reduce((a, b) => a + b, 0);
  for (let pass = 0; pass < 8 && slack > 0.001; pass += 1) {
    const room = eligible.map((it, i) =>
      it.capacity === Infinity ? Infinity : Math.max(0, it.capacity - allocHours[i])
    );
    const finiteRoomSum = room.reduce(
      (s, r, i) => s + (r === Infinity ? 0 : r),
      0
    );
    const hasInfRoom = room.some(r => r === Infinity);
    if (finiteRoomSum <= 0 && !hasInfRoom) break;

    let distributed = 0;
    for (let i = 0; i < eligible.length; i++) {
      if (room[i] <= 0) continue;
      let share: number;
      if (room[i] === Infinity) {
        share = (eligible[i].weight / weightSum) * slack;
      } else {
        share = (room[i] / finiteRoomSum) * Math.min(slack, finiteRoomSum);
      }
      const add = room[i] === Infinity ? share : Math.min(share, room[i]);
      allocHours[i] += add;
      distributed += add;
    }
    if (distributed <= 0.001) break;
    slack -= distributed;
  }

  const budgetSeconds = Math.round(budgetHours * 3600);
  const rawSeconds = allocHours.map(h => h * 3600);
  const secondsRounded = roundSecondsToMinutes(budgetSeconds, rawSeconds);

  return eligible.map((it, idx) => {
    const capSeconds =
      it.capacity === Infinity ? Infinity : Math.round(it.capacity * 3600);
    let seconds = secondsRounded[idx] ?? 0;
    if (capSeconds !== Infinity) seconds = Math.min(seconds, capSeconds);
    return {
      key: it.key,
      estimateHours: it.estimateHours,
      remainingHours: it.remainingHours,
      hours: seconds / 3600,
      seconds,
      timeSpent: formatSecondsToJiraTime(seconds),
    };
  });
}

/** Tổng giờ còn log được trên các ticket (theo estimate). */
export function sumRemainingLogHours(items: LogworkDistributeInput[]): number {
  let sum = 0;
  let hasUnlimited = false;
  for (const it of items) {
    const cap = getCapacityHours(it);
    if (cap === Infinity) {
      hasUnlimited = true;
      continue;
    }
    sum += cap;
  }
  return hasUnlimited ? Infinity : sum;
}
