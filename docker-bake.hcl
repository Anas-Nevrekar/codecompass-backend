variable "PLATFORMS" {
  default = "linux/amd64,linux/arm64"
}
variable "IMAGE" {
  default = "codecompass-backend:step1"
}
group "default" {
  targets = ["backend"]
}
target "backend" {
  context = "."
  dockerfile = "Dockerfile"
  platforms = split(",", PLATFORMS)
  tags = [IMAGE]
}
