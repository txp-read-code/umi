// READCODE doc文档的全局ts文件
// Redirect /zh-CN to /
if (location.pathname.startsWith('/zh-CN')) {
  location.href = `https://v3.umijs.org${location.pathname}`;
}
