// 기존 시각화도구/index.html의 색상 팔레트와 해시 함수를 그대로 이식.
// 같은 노드 유형은 항상 같은 색을 얻는다 (데이터와 무관하게 결정적).
export const COLOR_PALETTE = [
  '#e17055', '#00b894', '#0984e3', '#6c5ce7', '#a29bfe',
  '#fd79a8', '#fdcb6e', '#e84393', '#00cec9', '#55a3ff',
  '#ff6b6b', '#4ecdc4', '#45b7d1', '#96ceb4', '#ffeaa7',
  '#dda0dd', '#98d8c8', '#f7dc6f', '#bb8fce', '#85c1e9',
  '#ff7675', '#55efc4', '#81ecec', '#74b9ff', '#fab1a0',
];

export function getColorForNodeType(nodeType) {
  let hash = 0;
  for (let i = 0; i < nodeType.length; i++) {
    const char = nodeType.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  const colorIndex = Math.abs(hash) % COLOR_PALETTE.length;
  return COLOR_PALETTE[colorIndex];
}
