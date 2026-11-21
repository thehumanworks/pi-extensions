/** URL slug: lowercase ASCII words joined by hyphens. */
export default function slug(text) {
	return String(text).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
