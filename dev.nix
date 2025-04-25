nix
{ config, pkgs, ... }:

{
  environment.systemPackages = with pkgs; [
    git
    nodejs
    pnpm
  ];
}