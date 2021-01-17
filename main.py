import pygame
from config import *
from game import Game
from win32api import GetSystemMetrics



def setup():
    global screen, game, clock
    pygame.init()
    clock = pygame.time.Clock()
    
    S_WIDTH = GetSystemMetrics(0)
    S_HEIGHT = GetSystemMetrics(1)  
    screen = pygame.display.set_mode((int(S_WIDTH*0.5),int(S_HEIGHT*0.5)))
    pygame.display.set_caption("michess")
    pygame.display.set_icon(ICON)

    game = Game()

def main():
    running = True
    while running:
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                running = False

        draw_game(screen, game)
        clock.tick(FPS)
        pygame.display.flip()


def draw_game(surface, game):
    draw_board(surface)
    draw_pieces(surface, game)

def draw_board(surface):
    surface.fill(BLACK)
    for row in range(8):
        for col in range(8):
            if (row+col)%2 == 0: colour = WHITE_SQUARE
            else: colour = BLACK_SQUARE
            pygame.draw.rect(surface, colour, pygame.Rect((col*PIECE_SIZE+X_OFFSET,row*PIECE_SIZE+Y_OFFSET),(PIECE_SIZE,PIECE_SIZE)))
    


def draw_pieces(surface, game):
    squares = game.iter_squares()
    for square in squares:
        if square[1] != "x":
            x = X_OFFSET + square[0][1]*PIECE_SIZE
            y = Y_OFFSET + square[0][0]*PIECE_SIZE
            surface.blit(PIECES[square[1]],(x,y))


 
    
    #held_piece = PIECES["black_pawn"]
    held_piece = None
    if (held_piece):
        draw_held_piece(surface, held_piece)
    
def draw_held_piece(surface, piece):
    pygame.mouse.set_visible(False)
    mouseX, mouseY = pygame.mouse.get_pos()
    surface.blit(piece,(mouseX-30,mouseY-30))

    




if __name__ == "__main__":
    setup()
    main()