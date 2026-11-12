/**
 * Stands in for `page` from `$app/state` (mock the module with it), so a test
 * can do what SvelteKit does on every data refresh: give `page.url` a new
 * object for the same address.
 */
class FakeAppPage {
	url = $state.raw(new URL('https://bmuster.test/'));
}

export const fakeAppPage = new FakeAppPage();
