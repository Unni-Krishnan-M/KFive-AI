export function getToken(): string {
  try {
    const authData = localStorage.getItem('kfive-auth');
    if (!authData) return '';
    const parsed = JSON.parse(authData);
    return parsed?.state?.accessToken || '';
  } catch {
    return '';
  }
}
