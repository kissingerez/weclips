// Loads the Satoshi family (to match the weclips.app web design) plus the
// Comic Neue logo face. Returns [loaded, error] like useIconFonts.
import { useFonts } from "expo-font";

export const useAppFonts = (): readonly [boolean, Error | null] =>
  useFonts({
    "Satoshi-Light": require("../../assets/fonts/Satoshi-Light.ttf"),
    "Satoshi-Regular": require("../../assets/fonts/Satoshi-Regular.ttf"),
    "Satoshi-Medium": require("../../assets/fonts/Satoshi-Medium.ttf"),
    "Satoshi-Bold": require("../../assets/fonts/Satoshi-Bold.ttf"),
    "Satoshi-Black": require("../../assets/fonts/Satoshi-Black.ttf"),
    "ComicNeue-Bold": require("../../assets/fonts/ComicNeue-Bold.ttf"),
  });
