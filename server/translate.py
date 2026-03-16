"""英译中翻译模块 - 使用 argos-translate 本地离线"""
import argostranslate.package
import argostranslate.translate


def _has_package(from_code: str, to_code: str) -> bool:
    installed = argostranslate.package.get_installed_packages()
    return any(p.from_code == from_code and p.to_code == to_code for p in installed)


class Translator:
    def __init__(self, from_code: str = "en", to_code: str = "zh"):
        self.from_code = from_code
        self.to_code = to_code
        self._ensure_package()

    def _ensure_package(self):
        """确保 en->zh 语言包已安装"""
        if _has_package(self.from_code, self.to_code):
            return
        try:
            argostranslate.package.update_package_index()
            available = argostranslate.package.get_available_packages()
        except Exception as exc:
            raise RuntimeError(
                f"无法刷新 Argos Translate 语言包索引，请检查网络或镜像配置: {exc}"
            ) from exc

        pkg = next(
            (p for p in available if p.from_code == self.from_code and p.to_code == self.to_code),
            None,
        )
        if pkg is None:
            raise RuntimeError(
                f"未找到 Argos Translate 语言包: {self.from_code}->{self.to_code}"
            )

        try:
            path = pkg.download()
            argostranslate.package.install_from_path(path)
        except Exception as exc:
            raise RuntimeError(
                f"安装 Argos Translate 语言包失败: {self.from_code}->{self.to_code}: {exc}"
            ) from exc

    def translate(self, text: str) -> str:
        if not text.strip():
            return ""
        return argostranslate.translate.translate(text, self.from_code, self.to_code)
