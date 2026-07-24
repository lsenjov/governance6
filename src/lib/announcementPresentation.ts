export function formatAnnouncementOrdinal(index: number): string {
  return `ANN-${String(index + 1).padStart(2, "0")}`;
}

export function announcementNoteLabel(index: number, body: string): string {
  const excerpt = body.length > 80 ? `${body.slice(0, 80).trimEnd()}…` : body;
  return `${formatAnnouncementOrdinal(index)}: ${excerpt}`;
}
