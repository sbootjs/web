from pathlib import Path

from flask import Flask, send_from_directory


PROJECT_ROOT = Path(__file__).resolve().parent.parent
DIST_ROOT = PROJECT_ROOT / "dist"


def create_app():
    static_root = DIST_ROOT if DIST_ROOT.exists() else PROJECT_ROOT
    app = Flask(
        __name__,
        static_folder=str(static_root),
        static_url_path="",
    )

    @app.get("/")
    def index():
        return send_from_directory(static_root, "index.html")

    return app


app = create_app()


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
