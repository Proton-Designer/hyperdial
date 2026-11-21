/** TASK-H18: `hd-<slug of the campaign name>`: lowercase, spaces -> '-', a-z0-9- only. */
export function suggestCampaignTag(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug ? `hd-${slug}` : '';
}
