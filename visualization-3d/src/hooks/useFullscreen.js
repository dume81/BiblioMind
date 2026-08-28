import { useCallback, useEffect, useRef, useState } from 'react';

export const CSS_FALLBACK_MESSAGE = '브라우저 전체 화면을 사용할 수 없어 페이지 내 확대 모드로 전환했습니다.';

// 그래프 카드 wrapper 하나만 대상으로 하는 전체 화면 훅.
// - 표준 Fullscreen API를 우선 사용하고, 실패하면 CSS 확대 모드로 fallback.
// - 실제 상태는 document.fullscreenElement === container 로만 판단한다.
// - 브라우저 Esc 종료를 가로채지 않으며, fullscreenchange로 상태를 복원한다.
// - native fullscreen에서 정상 Esc 종료한 경우 fallback으로 재진입하지 않는다.
export function useFullscreen(containerRef, restoreFocusRef) {
  const [mode, setMode] = useState('normal'); // 'normal' | 'native' | 'css'
  const [announcement, setAnnouncement] = useState('');
  // 우리가 요청한 진입 시도 중에만 fullscreenerror를 fallback 사유로 취급한다.
  const requestingRef = useRef(false);
  const prevBodyOverflowRef = useRef('');

  const enterCssFallback = useCallback(() => {
    setMode('css');
    setAnnouncement(`${CSS_FALLBACK_MESSAGE} 전체 화면 모드로 전환했습니다.`);
  }, []);

  const enter = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    if (typeof el.requestFullscreen === 'function') {
      requestingRef.current = true;
      el.requestFullscreen().then(
        () => {
          requestingRef.current = false;
          // 상태 갱신은 fullscreenchange 이벤트가 담당한다.
        },
        () => {
          requestingRef.current = false;
          enterCssFallback();
        },
      );
    } else {
      enterCssFallback();
    }
  }, [containerRef, enterCssFallback]);

  const exit = useCallback(() => {
    if (document.fullscreenElement && typeof document.exitFullscreen === 'function') {
      document.exitFullscreen().catch(() => {
        // exit 실패 시에도 상태는 fullscreenchange 기준으로 유지된다.
      });
    } else {
      setMode((prev) => (prev === 'css' ? 'normal' : prev));
    }
  }, []);

  const toggle = useCallback(() => {
    if (mode === 'normal') enter();
    else exit();
  }, [mode, enter, exit]);

  // Fullscreen API 상태 동기화 — 버튼 클릭 여부로 추측하지 않는다.
  useEffect(() => {
    const handleChange = () => {
      const el = containerRef.current;
      if (document.fullscreenElement === el) {
        setMode('native');
        setAnnouncement('전체 화면으로 전환했습니다.');
      } else {
        // Esc·브라우저 UI·탭 전환으로 종료된 경우 포함. native 종료가 css로 새지 않게 한다.
        setMode((prev) => {
          if (prev === 'native') {
            setAnnouncement('전체 화면을 종료했습니다.');
            return 'normal';
          }
          return prev;
        });
      }
    };
    const handleError = () => {
      if (requestingRef.current) {
        requestingRef.current = false;
        enterCssFallback();
      }
    };
    document.addEventListener('fullscreenchange', handleChange);
    document.addEventListener('fullscreenerror', handleError);
    return () => {
      document.removeEventListener('fullscreenchange', handleChange);
      document.removeEventListener('fullscreenerror', handleError);
    };
  }, [containerRef, enterCssFallback]);

  // CSS 확대 모드: Esc로 종료 + body 스크롤 잠금(종료 시 기존 스타일 복원).
  useEffect(() => {
    if (mode !== 'css') return;
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        setMode('normal');
        setAnnouncement('전체 화면을 종료했습니다.');
      }
    };
    prevBodyOverflowRef.current = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = prevBodyOverflowRef.current;
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [mode]);

  // 종료 후 전체 화면 버튼으로 focus 복원.
  const prevModeRef = useRef('normal');
  useEffect(() => {
    if (prevModeRef.current !== 'normal' && mode === 'normal') {
      restoreFocusRef?.current?.focus?.();
    }
    prevModeRef.current = mode;
  }, [mode, restoreFocusRef]);

  return { mode, isFullscreen: mode !== 'normal', toggle, exit, announcement };
}
