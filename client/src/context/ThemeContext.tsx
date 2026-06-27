import React, {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from 'react';

export type ThemeMode = 'light' | 'dark';

const STORAGE_KEY = 'jira-genius-theme';
const USER_SET_KEY = 'jira-genius-theme-user-set';
const DEFAULT_CACHE_KEY = 'jira-genius-theme-default';

const API_BASE =
	import.meta.env.VITE_API_BASE_URL ?? (import.meta.env.PROD ? '' : 'http://localhost:5000');

type ThemeContextValue = {
	theme: ThemeMode;
	setTheme: (mode: ThemeMode) => void;
	toggleTheme: () => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function getUserThemePreferenceFromStorage(): ThemeMode | null {
	if (typeof window === 'undefined') return null;
	try {
		const user = JSON.parse(localStorage.getItem('user') || 'null');
		if (user?.theme_preference === 'light' || user?.theme_preference === 'dark') {
			return user.theme_preference;
		}
	} catch {
		/* ignore */
	}
	return null;
}

export function hasUserThemePreference(): boolean {
	if (typeof window === 'undefined') return false;
	if (getUserThemePreferenceFromStorage()) return true;
	return localStorage.getItem(USER_SET_KEY) === '1';
}

function readCachedDefaultTheme(): ThemeMode | null {
	if (typeof window === 'undefined') return null;
	const cached = localStorage.getItem(DEFAULT_CACHE_KEY);
	if (cached === 'light' || cached === 'dark') return cached;
	return null;
}

export function getStoredTheme(): ThemeMode {
	if (typeof window === 'undefined') return 'dark';

	const userPref = getUserThemePreferenceFromStorage();
	if (userPref) return userPref;

	if (localStorage.getItem(USER_SET_KEY) === '1') {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (stored === 'light' || stored === 'dark') return stored;
	}

	const cachedDefault = readCachedDefaultTheme();
	if (cachedDefault) return cachedDefault;

	if (window.matchMedia('(prefers-color-scheme: light)').matches) {
		return 'light';
	}
	return 'dark';
}

export function applyThemeToDocument(theme: ThemeMode) {
	document.documentElement.setAttribute('data-theme', theme);
}

export function cacheDefaultTheme(theme: ThemeMode) {
	localStorage.setItem(DEFAULT_CACHE_KEY, theme);
	if (!hasUserThemePreference()) {
		localStorage.setItem(STORAGE_KEY, theme);
		applyThemeToDocument(theme);
	}
}

export function notifyDefaultThemeChanged(theme: ThemeMode) {
	cacheDefaultTheme(theme);
	window.dispatchEvent(
		new CustomEvent<ThemeMode>('jira-default-theme-changed', { detail: theme }),
	);
}

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({
	children,
}) => {
	const [theme, setThemeState] = useState<ThemeMode>(() => getStoredTheme());

	useEffect(() => {
		applyThemeToDocument(theme);
		if (getUserThemePreferenceFromStorage() || localStorage.getItem(USER_SET_KEY) === '1') {
			localStorage.setItem(STORAGE_KEY, theme);
		}
	}, [theme]);

	useEffect(() => {
		const onDefaultChanged = (e: Event) => {
			const mode = (e as CustomEvent<ThemeMode>).detail;
			if (mode !== 'light' && mode !== 'dark') return;
			if (!hasUserThemePreference()) {
				setThemeState(mode);
			}
		};
		window.addEventListener('jira-default-theme-changed', onDefaultChanged);
		return () => window.removeEventListener('jira-default-theme-changed', onDefaultChanged);
	}, []);

	useEffect(() => {
		fetch(`${API_BASE}/api/config`)
			.then((res) => (res.ok ? res.json() : null))
			.then((data) => {
				if (!data?.defaultTheme || (data.defaultTheme !== 'light' && data.defaultTheme !== 'dark')) {
					return;
				}
				cacheDefaultTheme(data.defaultTheme);
				if (!hasUserThemePreference()) {
					setThemeState(data.defaultTheme);
				}
			})
			.catch(() => {});
	}, []);

	const syncThemeToBackend = (mode: ThemeMode) => {
		const token = localStorage.getItem('token');
		if (token) {
			fetch(`${API_BASE}/api/me/theme`, {
				method: 'PUT',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({ theme: mode }),
			}).catch(() => {});

			const userStr = localStorage.getItem('user');
			if (userStr) {
				try {
					const user = JSON.parse(userStr);
					user.theme_preference = mode;
					localStorage.setItem('user', JSON.stringify(user));
				} catch {
					/* ignore */
				}
			}
		}
	};

	const setTheme = useCallback((mode: ThemeMode) => {
		localStorage.setItem(USER_SET_KEY, '1');
		localStorage.setItem(STORAGE_KEY, mode);
		setThemeState(mode);
		syncThemeToBackend(mode);
	}, []);

	const toggleTheme = useCallback(() => {
		setThemeState((prev) => {
			const next = prev === 'dark' ? 'light' : 'dark';
			localStorage.setItem(USER_SET_KEY, '1');
			localStorage.setItem(STORAGE_KEY, next);
			syncThemeToBackend(next);
			return next;
		});
	}, []);

	const value = useMemo(
		() => ({ theme, setTheme, toggleTheme }),
		[theme, setTheme, toggleTheme],
	);

	return (
		<ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
	);
};

export function useTheme(): ThemeContextValue {
	const ctx = useContext(ThemeContext);
	if (!ctx) {
		throw new Error('useTheme must be used within ThemeProvider');
	}
	return ctx;
}
