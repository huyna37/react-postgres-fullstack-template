import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
	Loader2,
	Mail,
	Lock,
	Eye,
	EyeOff,
	LayoutDashboard,
	Sparkles,
	Bell,
	ArrowRight,
} from 'lucide-react';
import type { User } from '../types';
import { useTheme } from '../context/ThemeContext';
import ThemeToggle from './ThemeToggle';
import AppBrand from './AppBrand';

interface LoginFormProps {
	API_BASE_URL: string;
	setAuthToken: (token: string) => void;
	setCurrentUser: (user: User | null) => void;
}

const FEATURES = [
	{ icon: LayoutDashboard, text: 'Dashboard tiến độ theo tháng' },
	{ icon: Sparkles, text: 'Tạo ticket & viết lại nội dung bằng AI' },
	{ icon: Bell, text: 'Thông báo bug, subtask theo dự án' },
];

const LoginForm: React.FC<LoginFormProps> = ({
	API_BASE_URL,
	setAuthToken,
	setCurrentUser,
}) => {
	const [loginUsername, setLoginUsername] = useState('');
	const [loginPassword, setLoginPassword] = useState('');
	const [showPassword, setShowPassword] = useState(false);
	const [loginError, setLoginError] = useState('');
	const [loginLoading, setLoginLoading] = useState(false);
	const navigate = useNavigate();
	const { setTheme } = useTheme();

	const handleLogin = async (e: React.FormEvent) => {
		e.preventDefault();
		setLoginError('');
		setLoginLoading(true);
		try {
			const res = await fetch(`${API_BASE_URL}/api/auth/login`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					username: loginUsername.trim(),
					password: loginPassword,
				}),
			});
			const data = await res.json();
			if (res.ok) {
				localStorage.setItem('token', data.token);
				const userObj: User = {
					id: data.user.id,
					username: data.user.username,
					role: data.user.role,
					jira_token: data.user.jira_token,
					jira_project: data.user.jira_project,
					theme_preference: data.user.theme_preference,
					permissions: data.user.permissions,
				};
				localStorage.setItem('user', JSON.stringify(userObj));
				setAuthToken(data.token);
				setCurrentUser(userObj);
				if (userObj.theme_preference) {
					setTheme(userObj.theme_preference);
				}
				navigate('/dashboard');
			} else {
				setLoginError(
					data.error || 'Tài khoản hoặc mật khẩu không đúng.',
				);
			}
		} catch {
			setLoginError('Không kết nối được máy chủ. Thử lại sau.');
		} finally {
			setLoginLoading(false);
		}
	};

	return (
		<div className="login-page">
			<div className="login-page__theme">
				<ThemeToggle variant="default" />
			</div>
			<div className="login-page__bg" aria-hidden />
			<div className="login-page__grid">
				<section className="login-page__brand">
					<div className="login-page__brand-inner">
						<AppBrand variant="login" />
						<p className="login-page__lead">
							Quản lý ticket, logwork và kế hoạch sprint — đồng bộ
							Jira, thông báo theo dự án bạn được phân công.
						</p>
						<ul className="login-page__features">
							{FEATURES.map(({ icon: Icon, text }) => (
								<li key={text}>
									<span className="login-page__feature-icon">
										<Icon size={18} strokeWidth={2} />
									</span>
									{text}
								</li>
							))}
						</ul>
					</div>
				</section>

				<section className="login-page__panel">
					<div className="login-page__card">
						<header className="login-page__card-head">
							<h2>Đăng nhập</h2>
							<p>Email đầy đủ, username hoặc phần trước @ đều được</p>
						</header>

						<form
							className="login-page__form"
							onSubmit={handleLogin}
							noValidate
						>
							<div className="login-page__field">
								<label htmlFor="login-username">
									Tài khoản / Email
								</label>
								<div className="login-page__input-wrap">
									<Mail
										className="login-page__input-icon"
										size={18}
										aria-hidden
									/>
									<input
										id="login-username"
										type="text"
										autoComplete="username"
										placeholder="email hoặc username (vd. huy, huy@company.com)"
										value={loginUsername}
										onChange={(e) =>
											setLoginUsername(e.target.value)
										}
										required
										disabled={loginLoading}
									/>
								</div>
							</div>

							<div className="login-page__field">
								<label htmlFor="login-password">Mật khẩu</label>
								<div className="login-page__input-wrap">
									<Lock
										className="login-page__input-icon"
										size={18}
										aria-hidden
									/>
									<input
										id="login-password"
										type={
											showPassword ? 'text' : 'password'
										}
										autoComplete="current-password"
										placeholder="••••••••"
										value={loginPassword}
										onChange={(e) =>
											setLoginPassword(e.target.value)
										}
										required
										disabled={loginLoading}
									/>
									<button
										type="button"
										className="login-page__toggle-pw"
										onClick={() =>
											setShowPassword((v) => !v)
										}
										tabIndex={-1}
										aria-label={
											showPassword
												? 'Ẩn mật khẩu'
												: 'Hiện mật khẩu'
										}
										disabled={loginLoading}
									>
										{showPassword ? (
											<EyeOff size={18} />
										) : (
											<Eye size={18} />
										)}
									</button>
								</div>
							</div>

							{loginError ? (
								<div
									className="login-page__error"
									role="alert"
								>
									{loginError}
								</div>
							) : null}

							<button
								type="submit"
								className="login-page__submit"
								disabled={loginLoading}
							>
								{loginLoading ? (
									<>
										<Loader2
											size={20}
											className="spinner"
										/>
										Đang đăng nhập…
									</>
								) : (
									<>
										Đăng nhập
										<ArrowRight size={18} />
									</>
								)}
							</button>
						</form>

						<p className="login-page__hint">
							Liên hệ quản trị viên nếu chưa có tài khoản hoặc quên
							mật khẩu.
						</p>
					</div>
				</section>
			</div>
		</div>
	);
};

export default LoginForm;
