/** Convert YYYY-MM-DD (config) to dd-mm-yyyy (site format). */
export function toSiteDate(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) {
    throw new Error(`Invalid date "${isoDate}". Use YYYY-MM-DD in DATE env var.`);
  }
  const [, year, month, day] = match;
  return `${day}-${month}-${year}`;
}
