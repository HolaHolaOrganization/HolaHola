/** One filename mapping for rolling routing and its reverse lookup. */
export function episodeFilenameFromTitle(title: string): string {
  const exactNumber = /^Episode (\d+)$/i.exec(title);
  if (exactNumber) return `episode-${Number(exactNumber[1])}.md`;
  return title.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') + '.md';
}

export function selectEpisodeTarget<T extends { id: string; title: string }>(
  filename: string, rows: T[],
): T | null {
  if (!filename || filename.includes('/') || filename.includes('\\') || !filename.endsWith('.md')) {
    throw new Error('invalid_episode_target_filename');
  }
  const numbered = /^episode-(\d+)\.md$/.exec(filename);
  const matches = rows.filter(row => {
    if (episodeFilenameFromTitle(row.title) === filename) return true;
    // Also allow the canonical numbered name for a colon-subtitled episode.
    const titleNumber = /^Episode (\d+)(?:: .+)?$/i.exec(row.title);
    return numbered && titleNumber && Number(numbered[1]) === Number(titleNumber[1]);
  });
  if (matches.length > 1) throw new Error('ambiguous_episode_target');
  return matches[0] ?? null;
}
