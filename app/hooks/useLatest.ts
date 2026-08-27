import { useRef } from "react";

/**
 * Keep a ref mirror of a value so event handlers registered once can always
 * read the latest value without re-subscribing. Replaces the repeated
 * `const xRef = useRef(x); xRef.current = x;` boilerplate.
 */
export const useLatest = <T,>(value: T): React.RefObject<T> => {
  const ref = useRef(value);
  ref.current = value;
  return ref;
};
