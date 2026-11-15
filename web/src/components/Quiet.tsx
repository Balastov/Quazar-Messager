import { Component, type ReactNode } from "react";

/** Необязательная часть интерфейса (баннер обновления и т. п.): её сбой прячет только её саму. */
export default class Quiet extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("Необязательный блок интерфейса отключён из-за ошибки", error);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}
