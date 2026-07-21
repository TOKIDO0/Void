import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type DarkSelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

type DarkSelectProps = {
  value: string;
  options: DarkSelectOption[];
  placeholder?: string;
  disabled?: boolean;
  "aria-label"?: string;
  onChange: (value: string) => void;
};

type MenuPosition = {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
  openUpward: boolean;
};

const MENU_MAX_HEIGHT = 240;
const MENU_GAP = 6;

/** 深色主题自定义下拉：弹出层与设置弹窗同风格，用 portal 避免被 overflow 裁切。 */
export function DarkSelect({
  value,
  options,
  placeholder,
  disabled = false,
  "aria-label": ariaLabel,
  onChange
}: DarkSelectProps) {
  const listboxId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null);

  const selectedOption = options.find((option) => option.value === value && !option.disabled);
  const displayLabel = selectedOption?.label ?? placeholder ?? "";

  // 根据触发器位置计算菜单坐标，优先向下展开，空间不够则向上。
  const updateMenuPosition = () => {
    const trigger = triggerRef.current;
    if (!trigger) {
      return;
    }

    const rect = trigger.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom - MENU_GAP - 12;
    const spaceAbove = rect.top - MENU_GAP - 12;
    const openUpward = spaceBelow < 160 && spaceAbove > spaceBelow;
    const available = openUpward ? spaceAbove : spaceBelow;
    const maxHeight = Math.max(120, Math.min(MENU_MAX_HEIGHT, available));

    setMenuPosition({
      top: openUpward ? rect.top - MENU_GAP : rect.bottom + MENU_GAP,
      left: rect.left,
      width: rect.width,
      maxHeight,
      openUpward
    });
  };

  useLayoutEffect(() => {
    if (!isOpen) {
      setMenuPosition(null);
      return;
    }

    updateMenuPosition();
    const handleReposition = () => updateMenuPosition();
    window.addEventListener("resize", handleReposition);
    window.addEventListener("scroll", handleReposition, true);
    return () => {
      window.removeEventListener("resize", handleReposition);
      window.removeEventListener("scroll", handleReposition, true);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) {
        return;
      }
      setIsOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // 先关下拉，阻止事件冒泡到设置弹窗（否则会关掉整个设置）。
        event.stopPropagation();
        setIsOpen(false);
      }
    };

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [isOpen]);

  const handleSelect = (nextValue: string) => {
    onChange(nextValue);
    setIsOpen(false);
  };

  return (
    <div
      ref={rootRef}
      className={`dark-select${isOpen ? " is-open" : ""}${disabled ? " is-disabled" : ""}`}
    >
      <button
        ref={triggerRef}
        type="button"
        className="dark-select__trigger"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={listboxId}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => {
          if (!disabled) {
            setIsOpen((current) => !current);
          }
        }}
      >
        <span className={`dark-select__value${!selectedOption ? " is-placeholder" : ""}`}>
          {displayLabel}
        </span>
        <span className="dark-select__chevron" aria-hidden="true" />
      </button>

      {isOpen && menuPosition
        ? createPortal(
            <ul
              ref={menuRef}
              id={listboxId}
              className={`dark-select__menu${menuPosition.openUpward ? " is-upward" : ""}`}
              role="listbox"
              aria-label={ariaLabel}
              style={{
                top: menuPosition.openUpward ? "auto" : `${menuPosition.top}px`,
                bottom: menuPosition.openUpward
                  ? `${window.innerHeight - menuPosition.top}px`
                  : "auto",
                left: `${menuPosition.left}px`,
                width: `${menuPosition.width}px`,
                maxHeight: `${menuPosition.maxHeight}px`
              }}
            >
              {options.map((option) => {
                const isSelected = option.value === value;
                return (
                  <li key={option.value || option.label} role="presentation">
                    <button
                      type="button"
                      role="option"
                      className={`dark-select__option${isSelected ? " is-selected" : ""}`}
                      aria-selected={isSelected}
                      disabled={option.disabled}
                      onClick={() => {
                        if (!option.disabled) {
                          handleSelect(option.value);
                        }
                      }}
                    >
                      {option.label}
                    </button>
                  </li>
                );
              })}
            </ul>,
            document.body
          )
        : null}
    </div>
  );
}
