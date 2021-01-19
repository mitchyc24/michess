import pygame
pygame.init()

#Settings:
SOUNDS_ON = False
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
LIGHT_GREY = [200,200,200]
DARK_GREY = [75,75,75]
GREEN = [0,255,0]
BLUE = [0,0,255]
ORANGE = [255, 180, 0]

#Button Style
BUTTON_STYLE = {
    "font_color": BLACK,
    "hover_color": DARK_GREY,
    "clicked_color": GREEN,
    "clicked_font_color": BLACK,
    "hover_font_color": BLACK,
    "font": pygame.font.Font('freesansbold.ttf', 20)
    #"hover_sound": pygame.mixer.Sound("assets/sounds/blipshort1.wav"),
}


#Sounds
if SOUNDS_ON:
    SOUND_RELOAD = pygame.mixer.Sound("assets/sounds/shotgun-mossberg590-RA_The_Sun_God-451502290.wav")
    BUTTON_STYLE["hover_sound"] = pygame.mixer.Sound("assets/sounds/blipshort1.wav")