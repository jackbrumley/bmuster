/**
 * Loads the console again from the server. After a server update the console's own code is
 * new, so a data refresh is not enough. Its own module so the Updates page test can watch it.
 */
export function reloadPage(): void {
	window.location.reload();
}
