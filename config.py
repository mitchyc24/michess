import pygame


#Settings:
FPS = 60
SCREEN_SIZE = (800,500)
PIECE_SIZE = 60
X_OFFSET = 240
Y_OFFSET = 30
BOARD = ((X_OFFSET,Y_OFFSET),(X_OFFSET+PIECE_SIZE*8,Y_OFFSET+PIECE_SIZE*8))


#PIECES
EMPTY = "-"



#Images
ICON = pygame.image.load("assets/icon.png")
colours = ["b", "w"]
roles = ["q","k","b","n","r","p"]
PIECES = {}
for colour in colours:
    for role in roles:
        if colour == "b": piece = role[0]
        else:             piece = role[0].upper()
        PIECES[piece] = pygame.image.load("assets/"+ colour+role + ".png")


#Colours
GREY = [150,150,150]
RED = [255,0,0]
BLACK = [10,10,10]
WHITE = [255,255,255]
WHITE_SQUARE = [255,255,255]
BLACK_SQUARE = [50,50,50]