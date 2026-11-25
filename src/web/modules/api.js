export async function request(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    let message;
    try { message = (await response.json()).error; } catch { message = 'Không kết nối được ứng dụng local.'; }
    throw new Error(message || `Yêu cầu không thành công (${response.status}).`);
  }
  return response;
}
export async function json(url, options) { return (await request(url, options)).json(); }
export const post = (url, body) => json(url, { method: 'POST', ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
export const patch = (url, body) => json(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
