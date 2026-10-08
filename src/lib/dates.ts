// Calendar dates for India (policy start/end dates are Indian calendar dates, not UTC)
export function todayInIndia(offsetDays = 0): string {
  const d = new Date(Date.now() + 5.5 * 3_600_000 + offsetDays * 86_400_000);
  return d.toISOString().slice(0, 10);
}

// Start of an Indian calendar day as a real point in time (00:00 IST)
export const startOfIndianDay = (date: string): Date => new Date(`${date}T00:00:00+05:30`);

// "2026-10-06" → "06 Oct 2026" (how dates appear in messages and SMS)
export const formatDate = (iso: string): string =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });

// A real point in time → its Indian calendar date ("YYYY-MM-DD")
export const indianDateOf = (d: Date): string => new Date(d.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
