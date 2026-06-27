import React from 'react';
import { Link } from 'react-router-dom';
import BrandMark from './BrandMark';

type AppBrandProps = {
	variant?: 'sidebar' | 'login';
	/** Sidebar: link về dashboard khi đã đăng nhập */
	asLink?: boolean;
};

const TAGLINE = 'Jira AI · Đội ngũ';

const AppBrand: React.FC<AppBrandProps> = ({
	variant = 'sidebar',
	asLink = false,
}) => {
	const markSize = variant === 'login' ? 48 : 42;

	const content = (
		<div className={`app-brand app-brand--${variant}`}>
			<BrandMark size={markSize} className="app-brand__mark" />
			<div className="app-brand__text">
				<span className="app-brand__name">JiraGenius</span>
				<span className="app-brand__tagline">{TAGLINE}</span>
			</div>
		</div>
	);

	if (asLink && variant === 'sidebar') {
		return (
			<Link to="/dashboard" className="app-brand-link" title="Dashboard">
				{content}
			</Link>
		);
	}

	return content;
};

export default AppBrand;
