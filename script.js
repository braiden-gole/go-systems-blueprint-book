class GolangGopher {
    constructor() {
        this.canvas = document.getElementById("golang-canvas")

        if (!this.canvas) {
            return
        }

        this.context = this.canvas.getContext("2d")

        this.drawScene()

        window.addEventListener("resize", () => this.drawScene())
    }

    drawGopher(width, height) {
        this.context.save()

        const gopherWidth = Math.min(width * 0.5, height * 0.65)
        const gopherHeight = gopherWidth * 1.35

        const centerX = width / 2
        const topY = (height - gopherHeight) / 2 + gopherHeight * 0.15

        this.context.shadowColor = "rgba(0, 0, 0, 0.25)"
        this.context.shadowBlur = 15
        this.context.shadowOffsetY = 8

        const headGradient = this.context.createRadialGradient(
            centerX - gopherWidth * 0.15, topY + gopherHeight * 0.2, gopherWidth * 0.1,
            centerX, topY + gopherHeight * 0.5, gopherWidth * 0.7
        )

        headGradient.addColorStop(0, "#5ed9fb")
        headGradient.addColorStop(0.7, "#00add8")
        headGradient.addColorStop(1, "#007d9c")

        this.context.fillStyle = headGradient
        this.context.beginPath()
        this.context.roundRect(
            centerX - gopherWidth / 2,
            topY,
            gopherWidth,
            gopherHeight * 1.1,
            [gopherWidth * 0.45, gopherWidth * 0.45, gopherWidth * 0.2, gopherWidth * 0.2]
        )

        this.context.fill()

        this.context.shadowColor = "transparent"

        const earRadius = gopherWidth * 0.09

        this.context.fillStyle = "#00add8"

        this.context.beginPath()
        this.context.arc(centerX - gopherWidth * 0.45, topY + gopherHeight * 0.16, earRadius, 0, Math.PI * 2)
        this.context.fill()

        this.context.beginPath()
        this.context.arc(centerX + gopherWidth * 0.45, topY + gopherHeight * 0.16, earRadius, 0, Math.PI * 2)
        this.context.fill()

        const eyeRadius = gopherWidth * 0.21
        const leftEyeX = centerX - gopherWidth * 0.21
        const rightEyeX = centerX + gopherWidth * 0.21
        const eyeY = topY + gopherHeight * 0.24

        ;[leftEyeX, rightEyeX].forEach((eyeX) => {
            const eyeGradient = this.context.createRadialGradient(
                eyeX - eyeRadius * 0.2, eyeY - eyeRadius * 0.2, eyeRadius * 0.1,
                eyeX, eyeY, eyeRadius
            )

            eyeGradient.addColorStop(0, "#ffffff")
            eyeGradient.addColorStop(0.85, "#f0f4f8")
            eyeGradient.addColorStop(1, "#d1d5db")

            this.context.beginPath()
            this.context.arc(eyeX, eyeY, eyeRadius, 0, Math.PI * 2)
            this.context.fillStyle = eyeGradient
            this.context.fill()

            const pupilRadius = eyeRadius * 0.52

            this.context.beginPath()
            this.context.arc(eyeX, eyeY, pupilRadius, 0, Math.PI * 2)
            this.context.fillStyle = "#111827"
            this.context.fill()

            this.context.beginPath()
            this.context.arc(eyeX - pupilRadius * 0.35, eyeY - pupilRadius * 0.35, pupilRadius * 0.22, 0, Math.PI * 2)
            this.context.fillStyle = "rgba(255, 255, 255, 0.85)"
            this.context.fill()
        })

        const snoutY = eyeY + eyeRadius * 0.75

        this.context.beginPath()
        this.context.ellipse(centerX, snoutY, gopherWidth * 0.18, gopherWidth * 0.1, 0, 0, Math.PI * 2)
        this.context.fillStyle = "#e5c09f"
        this.context.fill()

        const noseY = snoutY - gopherWidth * 0.03

        this.context.beginPath()
        this.context.ellipse(centerX, noseY, gopherWidth * 0.08, gopherWidth * 0.055, 0, 0, Math.PI * 2)
        this.context.fillStyle = "#1e1e1e"
        this.context.fill()

        const teethY = snoutY + gopherWidth * 0.07
        const toothWidth = gopherWidth * 0.045
        const toothHeight = gopherWidth * 0.06

        this.context.fillStyle = "#ffffff"

        this.context.beginPath()
        this.context.roundRect(centerX - toothWidth - 1, teethY, toothWidth, toothHeight, [0, 0, 3, 3])
        this.context.fill()

        this.context.beginPath()
        this.context.roundRect(centerX + 1, teethY, toothWidth, toothHeight, [0, 0, 3, 3])
        this.context.fill()

        this.context.restore()
    }

    drawScene() {
        const width = this.canvas.clientWidth || 300
        const height = this.canvas.clientHeight || 200

        this.canvas.width = width
        this.canvas.height = height

        this.context.clearRect(0, 0, width, height)

        this.drawGopher(width, height)
    }
}

document.addEventListener("DOMContentLoaded", () => {
    new GolangGopher()
})