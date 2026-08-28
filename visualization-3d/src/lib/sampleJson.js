// 기존 시각화도구/index.html의 JSON 붙여넣기 textarea에 프리필되어 있던 샘플 데이터(그대로 이식).
export const SAMPLE_JSON_TEXT = `{
  "nodes": [
    {
      "id": "N0",
      "label": "사람",
      "properties": {
        "name": "에렌 예거"
      }
    },
    {
      "id": "N1",
      "label": "사람",
      "properties": {
        "name": "미카사 아커만"
      }
    },
    {
      "id": "N10",
      "label": "사람",
      "properties": {
        "name": "그리샤 예거"
      }
    },
    {
      "id": "N13",
      "label": "거인",
      "properties": {
        "name": "초대형 거인"
      }
    },
    {
      "id": "N2",
      "label": "사람",
      "properties": {
        "name": "아르민 알레르트"
      }
    },
    {
      "id": "N7",
      "label": "사람",
      "properties": {
        "name": "라이너 브라운"
      }
    },
    {
      "id": "N14",
      "label": "거인",
      "properties": {
        "name": "갑옷 거인"
      }
    },
    {
      "id": "N12",
      "label": "거인",
      "properties": {
        "name": "진격의 거인"
      }
    },
    {
      "id": "N6",
      "label": "사람",
      "properties": {
        "name": "장 키르슈타인"
      }
    },
    {
      "id": "N8",
      "label": "사람",
      "properties": {
        "name": "베르톨트 후버"
      }
    },
    {
      "id": "N9",
      "label": "사람",
      "properties": {
        "name": "애니 레온하트"
      }
    }
  ],
  "relationships": [
    {
      "type": "IS_FRIEND_OF",
      "start_node_id": "N0",
      "end_node_id": "N1",
      "properties": {
        "episode_number": "S1E1"
      }
    },
    {
      "type": "IS_FATHER_OF",
      "start_node_id": "N10",
      "end_node_id": "N0",
      "properties": {
        "episode_number": "S1E1"
      }
    },
    {
      "type": "DESTROYS_GATE",
      "start_node_id": "N13",
      "end_node_id": "N0",
      "properties": {
        "episode_number": "S1E1"
      }
    },
    {
      "type": "JOINS_ARMY_WITH",
      "start_node_id": "N0",
      "end_node_id": "N1",
      "properties": {
        "episode_number": "S1E2"
      }
    },
    {
      "type": "JOINS_ARMY_WITH",
      "start_node_id": "N0",
      "end_node_id": "N2",
      "properties": {
        "episode_number": "S1E2"
      }
    },
    {
      "type": "JOINS_ARMY_WITH",
      "start_node_id": "N1",
      "end_node_id": "N2",
      "properties": {
        "episode_number": "S1E2"
      }
    },
    {
      "type": "VOWS_TO_ERADICATE",
      "start_node_id": "N0",
      "end_node_id": "N12",
      "properties": {
        "episode_number": "S1E2"
      }
    },
    {
      "type": "BREACHES_WALL",
      "start_node_id": "N14",
      "end_node_id": "N0",
      "properties": {
        "wall": "Wall Maria",
        "episode_number": "S1E2"
      }
    },
    {
      "type": "BREACHES_WALL",
      "start_node_id": "N14",
      "end_node_id": "N1",
      "properties": {
        "wall": "Wall Maria",
        "episode_number": "S1E2"
      }
    },
    {
      "type": "IS_ARMOR_TITAN_SHIFTER",
      "start_node_id": "N7",
      "end_node_id": "N14",
      "properties": {
        "episode_number": "S1E2"
      }
    },
    {
      "type": "RIVAL",
      "start_node_id": "N0",
      "end_node_id": "N6",
      "properties": {
        "episode_number": "S1E3"
      }
    },
    {
      "type": "ASKS_HELP",
      "start_node_id": "N0",
      "end_node_id": "N7",
      "properties": {
        "episode_number": "S1E3"
      }
    },
    {
      "type": "ASKS_HELP",
      "start_node_id": "N0",
      "end_node_id": "N8",
      "properties": {
        "episode_number": "S1E3"
      }
    },
    {
      "type": "PERSONALLY_ENCOUNTERED",
      "start_node_id": "N0",
      "end_node_id": "N12",
      "properties": {
        "episode_number": "S1E3"
      }
    },
    {
      "type": "PERSONALLY_ENCOUNTERED",
      "start_node_id": "N7",
      "end_node_id": "N13",
      "properties": {
        "episode_number": "S1E3"
      }
    },
    {
      "type": "PERSONALLY_ENCOUNTERED",
      "start_node_id": "N8",
      "end_node_id": "N13",
      "properties": {
        "episode_number": "S1E3"
      }
    },
    {
      "type": "TRAINS_WITH",
      "start_node_id": "N0",
      "end_node_id": "N9",
      "properties": {
        "episode_number": "S1E4"
      }
    },
    {
      "type": "LEARNS_WITH",
      "start_node_id": "N0",
      "end_node_id": "N6",
      "properties": {
        "episode_number": "S1E4"
      }
    },
    {
      "type": "JOINS_REGIMENT_WITH",
      "start_node_id": "N0",
      "end_node_id": "N2",
      "properties": {
        "episode_number": "S1E4"
      }
    },
    {
      "type": "JOINS_REGIMENT_WITH",
      "start_node_id": "N0",
      "end_node_id": "N1",
      "properties": {
        "episode_number": "S1E4"
      }
    },
    {
      "type": "SHOCKED_BY",
      "start_node_id": "N0",
      "end_node_id": "N13",
      "properties": {
        "episode_number": "S1E4"
      }
    },
    {
      "type": "SHOCKED_BY",
      "start_node_id": "N6",
      "end_node_id": "N13",
      "properties": {
        "episode_number": "S1E4"
      }
    },
    {
      "type": "ATTACKED",
      "start_node_id": "N0",
      "end_node_id": "N13",
      "properties": {
        "episode_number": "S1E5"
      }
    },
    {
      "type": "ATTEMPTED_TO_SAVE",
      "start_node_id": "N0",
      "end_node_id": "N2",
      "properties": {
        "episode_number": "S1E5"
      }
    },
    {
      "type": "KNOWS",
      "start_node_id": "N2",
      "end_node_id": "N0",
      "properties": {
        "episode_number": "S1E6"
      }
    },
    {
      "type": "KNOWS",
      "start_node_id": "N2",
      "end_node_id": "N1",
      "properties": {
        "episode_number": "S1E6"
      }
    },
    {
      "type": "KNOWS",
      "start_node_id": "N1",
      "end_node_id": "N0",
      "properties": {
        "episode_number": "S1E6"
      }
    },
    {
      "type": "KNOWS",
      "start_node_id": "N0",
      "end_node_id": "N1",
      "properties": {
        "episode_number": "S1E6"
      }
    },
    {
      "type": "FAMILY",
      "start_node_id": "N10",
      "end_node_id": "N0",
      "properties": {
        "episode_number": "S1E6"
      }
    },
    {
      "type": "FAMILY",
      "start_node_id": "N10",
      "end_node_id": "N1",
      "properties": {
        "episode_number": "S1E6"
      }
    }
  ]
}`;
