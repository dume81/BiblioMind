function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

// 표시 이름 우선순위: properties.name → properties.title → properties.label → node.id
// 원본 속성은 변경하지 않는다.
export function getNodeDisplayName(node) {
  const props = node.properties || {};
  return (
    nonEmptyString(props.name) ||
    nonEmptyString(props.title) ||
    nonEmptyString(props.label) ||
    String(node.id)
  );
}
