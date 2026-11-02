export function newPasswordProblem(password: string, confirmation: string): string | null {
  if (Array.from(password).length < 8 || !password.trim()) return "Пароль — не короче 8 символов и не из одних пробелов";
  if (new TextEncoder().encode(password).length > 72) return "Пароль слишком длинный. Используйте более короткий пароль";
  if (password !== confirmation) return "Новые пароли не совпадают";
  return null;
}
