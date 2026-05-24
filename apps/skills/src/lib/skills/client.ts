import { openSkillsBrowser } from './browser.js';

export const skills = openSkillsBrowser();

if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		skills[Symbol.dispose]();
	});
}
