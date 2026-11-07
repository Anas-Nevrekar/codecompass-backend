variable "PLATFORMS" {
  default = "linux/amd64,linux/arm64"
}
variable "IMAGE" {
  default = "ghcr.io/anas-nevrekar/codecompass-backend"
}
variable "TAG" {
  default = "local"
}
group "default" {
  targets = ["backend"]
}
target "backend" {
  context = "."
  dockerfile = "Dockerfile"
  platforms = split(",", PLATFORMS)
  tags = ["${IMAGE}:latest", "${IMAGE}:${TAG}"]
}
