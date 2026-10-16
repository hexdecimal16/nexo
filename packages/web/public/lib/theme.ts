// Marks the current page in the nav and cycles the theme: system, light, dark. The choice is kept in localStorage.

const KEY = 'nexo-theme';
type Choice = 'system' | 'light' | 'dark';
const ORDER: readonly Choice[] = ['system', 'light', 'dark'];

function read(): Choice {
	try {
		const value = localStorage.getItem(KEY);
		return value === 'light' || value === 'dark' ? value : 'system';
	} catch {
		return 'system';
	}
}

function apply(choice: Choice): void {
	if (choice === 'system') delete document.documentElement.dataset.theme;
	else document.documentElement.dataset.theme = choice;
}

function markActive(nav: Element): void {
	const path = location.pathname;
	const target = path === '/' || path === '/index.html' || path === '/run.html' ? '/' : path;
	for (const a of nav.querySelectorAll('a:not(.brand)')) {
		if (a.getAttribute('href') === target) a.setAttribute('aria-current', 'page');
	}
}

function addToggle(nav: Element): void {
	let choice = read();
	const button = document.createElement('button');
	button.type = 'button';
	button.className = 'theme-toggle';
	const label = (): void => {
		button.textContent = `theme: ${choice}`;
		button.setAttribute('aria-label', `Theme: ${choice}. Activate to change.`);
	};
	button.addEventListener('click', () => {
		choice = ORDER[(ORDER.indexOf(choice) + 1) % ORDER.length] ?? 'system';
		apply(choice);
		try {
			if (choice === 'system') localStorage.removeItem(KEY);
			else localStorage.setItem(KEY, choice);
		} catch {
			// Storage can be unavailable; the choice then lasts for this page only.
		}
		label();
	});
	label();
	nav.append(button);
}

apply(read());
const nav = document.querySelector('nav.top');
if (nav) {
	markActive(nav);
	addToggle(nav);
}

export {};
