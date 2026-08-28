// 사용자가 JSON 대신 파일 경로 문자열을 붙여넣는 경우를 감지한다.
// 웹브라우저는 보안상 경로 문자열만으로 로컬 파일을 읽을 수 없으므로,
// 이런 입력은 파일로 읽으려 시도하지 않고 안내 메시지를 보여준다.
const PATH_PATTERNS = [
  /^[A-Za-z]:[\\/]/, //  C:\...  또는 C:/...
  /^\\\\/, //            \\server\share (UNC)
  /^file:\/\//i, //      file:///C:/...
];

export const PATH_STRING_GUIDE_MESSAGE =
  '웹브라우저에서는 파일 경로 문자열만으로 로컬 파일을 읽을 수 없습니다.\n"JSON 파일" 탭에서 파일을 선택하거나 끌어 놓으세요.';

export function looksLikeFilePath(text) {
  const trimmed = (text || '').trim();
  if (trimmed === '') return false;
  return PATH_PATTERNS.some((pattern) => pattern.test(trimmed));
}
