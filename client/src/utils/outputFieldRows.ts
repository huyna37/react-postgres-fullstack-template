/** Số dòng hiển thị cho ô output — ít text thì thấp, nhiều text thì cao hơn (có giới hạn). */
export function outputFieldRows(text: string, min = 1, max = 10) {
  const value = String(text || '');
  if (!value.trim()) return min;

  const wrapped = value.split('\n').reduce((sum, line) => {
    const chars = line.length;
    return sum + Math.max(1, Math.ceil(chars / 76));
  }, 0);

  return Math.min(max, Math.max(min, wrapped));
}
