import React from 'react';
import { Moon, Sun } from 'lucide-react';
import { useTheme } from '../context/ThemeContext';

type ThemeToggleProps = {
	className?: string;
	/** compact = icon only in sidebar */
	variant?: 'default' | 'compact';
};

const ThemeToggle: React.FC<ThemeToggleProps> = ({
	className = '',
	variant = 'default',
}) => {
	const { theme, toggleTheme } = useTheme();
	const isDark = theme === 'dark';

	return (
		<button
			type="button"
			className={`theme-toggle theme-toggle--${variant} ${className}`.trim()}
			onClick={toggleTheme}
			aria-label={isDark ? 'Chuyển sang sáng' : 'Chuyển sang tối'}
			title={isDark ? 'Light mode' : 'Dark mode'}
		>
			{isDark ? <Sun size={18} /> : <Moon size={18} />}
			{variant === 'default' && (
				<span>{isDark ? 'Giao diện sáng' : 'Giao diện tối'}</span>
			)}
		</button>
	);
};

export default ThemeToggle;
