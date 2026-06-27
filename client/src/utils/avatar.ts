function appAuthSuffix(): string {
  if (typeof window === 'undefined') return '';
  const token = localStorage.getItem('token');
  return token ? `&token=${encodeURIComponent(token)}` : '';
}

export const getAvatarUrl = (url: string | null | undefined, apiBaseUrl: string): string => {
  if (!url) return '';
  if (url.startsWith('http') || url.startsWith('/')) {
    if (url.includes('/api/users/avatar')) return url;
    return `${apiBaseUrl}/api/users/avatar?url=${encodeURIComponent(url)}${appAuthSuffix()}`;
  }
  return url;
};
