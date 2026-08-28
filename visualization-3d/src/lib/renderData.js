import { getColorForNodeType } from './colors.js';
import { getNodeDisplayName } from './displayName.js';

// Canonical Graph → react-force-graph-3d용 렌더 데이터.
// 렌더 데이터는 항상 깊은 복제본이다: react-force-graph-3d가 link의 source/target을
// 객체로 바꾸고 노드에 좌표(x, y, z, vx...)를 주입해도 Canonical Graph는 변하지 않는다.

function propsTable(props) {
  const keys = Object.keys(props || {});
  if (!keys.length) return '';
  return '\n' + keys.map((k) => `${k}: ${String(props[k])}`).join('\n');
}

export function makeNodeTooltip(label, props) {
  return label + propsTable(props);
}

export function makeLinkTooltip(type, props) {
  return (type || 'RELATES') + propsTable(props);
}

// 같은 노드 쌍 사이의 다중·역방향 관계와 셀프 관계를 곡률로 시각적으로 분리한다.
function assignCurvatures(links) {
  const groups = new Map();
  links.forEach((link) => {
    const [a, b] = [link.source, link.target].sort();
    // ID에 공백 등 임의 문자가 올 수 있으므로 충돌 없는 키 인코딩을 쓴다.
    const key = JSON.stringify([a, b]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(link);
  });

  groups.forEach((group) => {
    const isSelfGroup = group[0].source === group[0].target;
    if (group.length === 1 && !isSelfGroup) {
      group[0].curvature = 0;
      group[0].curveRotation = 0;
      return;
    }
    group.forEach((link, i) => {
      // 셀프 관계는 곡률이 0이면 아예 보이지 않으므로 항상 곡률을 준다.
      link.curvature = link.source === link.target ? 0.6 : 0.4;
      link.curveRotation = (2 * Math.PI * i) / group.length;
    });
  });
}

export function buildRenderData(graph) {
  const nodes = graph.nodes.map((node) => ({
    id: node.id,
    name: getNodeDisplayName(node),
    label: node.label,
    color: getColorForNodeType(node.label),
    properties: structuredClone(node.properties),
  }));

  const links = graph.relationships.map((rel) => ({
    id: rel.id,
    type: rel.type,
    source: rel.start_node_id,
    target: rel.end_node_id,
    properties: structuredClone(rel.properties),
  }));

  assignCurvatures(links);

  return { nodes, links };
}
