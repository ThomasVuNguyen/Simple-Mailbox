const DAY = 24 * 3600_000;

const startOfDay = (t: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** For lists: "10:42", "Yesterday", "Mon", "Nov 12". */
export function shortTime(t: number, now = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(t)) / DAY);
  if (days <= 0) return clock(t);
  if (days === 1) return 'Yesterday';
  if (days < 7) return new Date(t).toLocaleDateString([], { weekday: 'short' });
  return new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** For a single email: "Today, 10:42", "Nov 12, 10:42". */
export function longTime(t: number, now = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(t)) / DAY);
  const day = days <= 0 ? 'Today' : days === 1 ? 'Yesterday' : new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
  return `${day}, ${clock(t)}`;
}

export { clock };
