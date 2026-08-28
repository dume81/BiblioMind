// 드래그 고정 노드 추적기 (이슈 1 회귀 수정).
// 렌더 노드 객체를 참조로 추적하므로, 필터로 화면에서 제외된 노드도
// releaseAll()에서 빠짐없이 해제된다. Graph3D가 사용하며 단위 테스트 대상이다.
export function createPinTracker() {
  const pinned = new Set();

  return {
    // 노드를 현재 위치에 고정하고 추적 목록에 추가한다.
    pin(node) {
      node.fx = node.x;
      node.fy = node.y;
      node.fz = node.z;
      pinned.add(node);
    },
    // 추적된 모든 노드의 고정을 해제한다. 해제된 개수를 반환한다.
    releaseAll() {
      const count = pinned.size;
      pinned.forEach((node) => {
        delete node.fx;
        delete node.fy;
        delete node.fz;
      });
      pinned.clear();
      return count;
    },
    // 새 그래프로 교체되면 렌더 객체가 새로 생성되므로 추적만 초기화한다.
    clear() {
      pinned.clear();
    },
    get size() {
      return pinned.size;
    },
  };
}
