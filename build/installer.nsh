; ── NarraVoz — NSIS custom uninstall ────────────────────────────────────────
; Limpia el runtime (Python+deps) y el modelo XTTS descargados fuera de la
; carpeta de la app, y ofrece conservar las voces personalizadas del usuario.

!macro customUnInstall
  ; ¿Conservar las voces personalizadas?
  MessageBox MB_YESNO|MB_ICONQUESTION "¿Quieres conservar tus voces personalizadas?$\n$\nSí: se mantiene tu carpeta de voces; se elimina el resto (modelo, dependencias y configuración).$\nNo: se elimina todo lo de NarraVoz." IDYES nv_keep_voices IDNO nv_delete_all

  nv_delete_all:
    RMDir /r "$APPDATA\NarraVoz"
    Goto nv_clean_runtime

  nv_keep_voices:
    ; Respaldar voces en el mismo disco, borrar userData, restaurar voces
    RMDir /r "$LOCALAPPDATA\NarraVoz\__voices_backup"
    Rename "$APPDATA\NarraVoz\voices" "$LOCALAPPDATA\NarraVoz\__voices_backup"
    RMDir /r "$APPDATA\NarraVoz"
    CreateDirectory "$APPDATA\NarraVoz"
    Rename "$LOCALAPPDATA\NarraVoz\__voices_backup" "$APPDATA\NarraVoz\voices"
    RMDir /r "$LOCALAPPDATA\NarraVoz\__voices_backup"

  nv_clean_runtime:
    ; Runtime (venv + Python gestionado + caché de uv) y modelo XTTS
    RMDir /r "$LOCALAPPDATA\NarraVoz\runtime"
    RMDir /r "$LOCALAPPDATA\NarraVoz\models"
    ; Eliminar la carpeta NarraVoz de LocalAppData si quedó vacía
    RMDir "$LOCALAPPDATA\NarraVoz"
!macroend
