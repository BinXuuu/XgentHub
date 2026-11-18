import { useEffect, useState, type CSSProperties, type MouseEvent } from "react";

const MENU_HEIGHT = 110;

// 列表本身是滚动容器，absolute 弹出的菜单会被裁掉；改成按按钮位置 fixed 定位，下方放不下就往上弹。
export function useRowMenu() {
  const [menu, setMenu] = useState<{ id: string; style: CSSProperties } | null>(null);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [menu]);

  function toggleMenu(id: string, event: MouseEvent<HTMLElement>) {
    if (menu?.id === id) {
      setMenu(null);
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const right = window.innerWidth - rect.right;
    const openUp = window.innerHeight - rect.bottom < MENU_HEIGHT + 12;
    setMenu({
      id,
      style: openUp
        ? { position: "fixed", top: "auto", bottom: window.innerHeight - rect.top + 6, right }
        : { position: "fixed", top: rect.bottom + 6, right },
    });
  }

  return { openMenuId: menu?.id ?? null, menuStyle: menu?.style, toggleMenu, closeMenu: () => setMenu(null) };
}
