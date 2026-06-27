import React from 'react';

type BrandMarkProps = {
	size?: number;
	className?: string;
};

/** Logo mark JiraGenius — gradient tile + kanban + spark */
const BrandMark: React.FC<BrandMarkProps> = ({
	size = 44,
	className = '',
}) => {
	const id = React.useId().replace(/:/g, '');
	const gradId = `jg-grad-${id}`;
	const glowId = `jg-glow-${id}`;

	return (
		<svg
			className={`brand-mark ${className}`.trim()}
			width={size}
			height={size}
			viewBox="0 0 48 48"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
			aria-hidden
		>
			<defs>
				<linearGradient
					id={gradId}
					x1="6"
					y1="4"
					x2="42"
					y2="44"
					gradientUnits="userSpaceOnUse"
				>
					<stop stopColor="#818cf8" />
					<stop offset="0.45" stopColor="#6366f1" />
					<stop offset="1" stopColor="#7c3aed" />
				</linearGradient>
				<filter
					id={glowId}
					x="-20%"
					y="-20%"
					width="140%"
					height="140%"
				>
					<feGaussianBlur stdDeviation="1.2" result="blur" />
					<feMerge>
						<feMergeNode in="blur" />
						<feMergeNode in="SourceGraphic" />
					</feMerge>
				</filter>
			</defs>
			<rect
				width="48"
				height="48"
				rx="14"
				fill={`url(#${gradId})`}
			/>
			<rect
				x="1"
				y="1"
				width="46"
				height="46"
				rx="13"
				stroke="rgba(255,255,255,0.22)"
				strokeWidth="1"
			/>
			{/* Kanban columns */}
			<rect
				x="11"
				y="14"
				width="7"
				height="22"
				rx="2"
				fill="rgba(255,255,255,0.92)"
			/>
			<rect
				x="20.5"
				y="18"
				width="7"
				height="18"
				rx="2"
				fill="rgba(255,255,255,0.75)"
			/>
			<rect
				x="30"
				y="22"
				width="7"
				height="14"
				rx="2"
				fill="rgba(255,255,255,0.55)"
			/>
			{/* AI spark */}
			<path
				filter={`url(#${glowId})`}
				d="M36.5 10.5l1.1 2.4 2.4 1.1-2.4 1.1-1.1 2.4-1.1-2.4-2.4-1.1 2.4-1.1 1.1-2.4z"
				fill="#fde68a"
			/>
			<circle cx="36.5" cy="10.5" r="1.2" fill="#fff" opacity="0.9" />
		</svg>
	);
};

export default BrandMark;
