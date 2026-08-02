# Tizen signing material

Do not put certificate profiles, `.p12` files, passwords, or TV DUID material in this repository. Mount the existing Samsung certificate profile read-only into the Tizen build container when packaging. Developer mode is already enabled on the target S90C; certificate creation and device registration remain user-assisted steps.
