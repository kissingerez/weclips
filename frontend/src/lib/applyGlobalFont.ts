// Applies Satoshi globally (to match weclips.app) by patching <Text> and
// <TextInput> render so each picks the right Satoshi face for its fontWeight.
// Elements that already declare a fontFamily (icon fonts, the Comic Neue logo)
// are left untouched.
import React from "react";
import { Text as RNText, TextInput as RNTextInput, StyleSheet } from "react-native";

function weightToFamily(w?: string | number): string {
  const s = String(w ?? "400");
  if (s === "100" || s === "200" || s === "300" || s === "light") return "Satoshi-Light";
  if (s === "500" || s === "medium") return "Satoshi-Medium";
  if (s === "600" || s === "700" || s === "800" || s === "bold" || s === "semibold")
    return "Satoshi-Bold";
  if (s === "900" || s === "black") return "Satoshi-Black";
  return "Satoshi-Regular";
}

let patched = false;

export function applyGlobalFont(): void {
  if (patched) return;
  patched = true;

  for (const Comp of [RNText, RNTextInput] as any[]) {
    const orig = Comp.render;
    if (typeof orig !== "function") continue;
    Comp.render = function (...args: any[]) {
      const el = orig.apply(this, args);
      const flat = StyleSheet.flatten(el.props.style) || {};
      if (flat.fontFamily) return el; // respect explicit fonts (icons, logo)
      const fontFamily = weightToFamily(flat.fontWeight);
      return React.cloneElement(el, {
        style: [{ fontFamily }, el.props.style],
      });
    };
  }
}
